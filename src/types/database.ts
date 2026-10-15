export type Database = {
  public: {
    Functions: {
      get_public_wall_chunk: {
        Args: {
          p_min_x: number;
          p_max_x: number;
          p_min_y: number;
          p_max_y: number;
        };
        Returns: {
          id: number;
          x: number;
          y: number;
          owner_name: string | null;
          public_image_url: string | null;
          is_listed: boolean;
          is_owned: boolean;
        }[];
      };
      get_public_base_price: {
        Args: Record<string, never>;
        Returns: number;
      };
    };
  };
};

export type BrickData =
  Database["public"]["Functions"]["get_public_wall_chunk"]["Returns"][0];
